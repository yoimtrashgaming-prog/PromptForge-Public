// The benchmark sheets, served to a tab instead of read out of docs/.
//
// Every measurement this project has taken lives in docs/ as a file somebody
// has to know the name of. That is fine for the person who wrote it and
// useless to the other four, so the numbers get re-asked in chat instead —
// which quant is fastest, what does h3 cost, why is the 27B slow today.
//
// This serves the sheets themselves and runs nothing. Running one is the
// owner's "Run benchmark" button, a separate module (server/benchrun.mjs)
// that queues like any generation and writes its result into the same
// folder this reads.
//
// ── Why an allowlist and not a directory scan ──────────────────────────────
//
// The route takes an id from the URL, and the only reason it cannot be talked
// into serving `../../config/server.local.yaml` is that the id never touches
// the filesystem — it is looked up in the table below, which is a constant.
// Same argument as DIRECTOR_DOC in server.mjs, and the same shape. A scan of
// docs/ would also publish the handoffs, the security plan and the open
// questions, none of which are benchmarks.
//
// Adding a sheet is one row here, or just a file in data/benchmarks/ (below).

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/**
 * The sheets, newest first. `date` is the measurement's date, not the file's —
 * a benchmark is only meaningful next to when it was taken and on what.
 *
 * `summary` is what someone reads to decide whether to open it, so it says
 * what the sheet ANSWERS rather than what it is called.
 *
 * `generated` means the file is data, not a document: the sheet is drawn from
 * it by renderCompare() below. The first entry is the one the tab opens on.
 */
export const SHEETS = [
  {
    id: 'p40-vs-v100',
    file: 'benchmarks.yaml',
    generated: true,
    title: 'P40 vs V100',
    date: '2026-09-11',
    summary:
      'Both cards on the same tests under the same conditions: decode per model, engine and ' +
      'draft depth, VRAM headroom, idle wake and the prefix cache.',
  },
  {
    id: 'v100-candidates',
    file: 'v100-candidates-2026-09-15.md',
    title: 'V100 candidates: Q6 and Gemma',
    date: '2026-09-15',
    summary:
      'HauhauCS Q6_K_P and Gemma 4 31B against the Q4_K_P baseline on the V100 — decode, ' +
      'prefill, VRAM and draft-head acceptance, each with a same-session control.',
  },
  {
    id: 'v100-bench',
    file: 'v100-bench-2026-09-11.md',
    title: 'V100 Bench Sheet',
    date: '2026-09-11',
    summary:
      'The V100 re-running every P40 test, how it was run, what the rebuild for Volta bought, ' +
      'and what does not transfer.',
  },
  {
    id: 'p40-bench',
    file: 'p40-bench-2026-09-03.html',
    title: 'P40 Bench Sheet',
    date: '2026-09-03',
    summary:
      'Decode throughput per quant, why FastMTP will not load, memory and context ceilings, ' +
      'what each model’s prompt costs, and the HauhauCS quant ladder.',
  },
  {
    id: 'engine-eval',
    file: 'engine-eval-2026-09-01.md',
    title: 'Engine evaluation',
    date: '2026-09-01',
    summary:
      'Ollama against llama.cpp on the same weights — the measurement behind moving prompt ' +
      'generation to llama-swap.',
  },
  {
    id: 'traits-eval',
    file: 'traits-eval-2026-08-26.md',
    title: 'Character traits evaluation',
    date: '2026-08-26',
    summary: 'How the danbooru character lookup performs, and where it declines to answer.',
  },
];

// NOT listed: archive/docs/model-eval-2026-08-18.md.
//
// It was measured on the Windows dev box — an RTX 5080, 16GB, Blackwell — and
// that stopped being a target on 2 Sep 2026 when the P40 became the only box.
// Owner's call, 4 Sep: this tab shows what was measured on the P40 and
// nothing else. A retired machine's throughput sitting one click from the
// current numbers is worth less than the space it takes, and it invites
// exactly the comparison data/benchmarks/benchmarks.yaml refuses to make.
//
// **The file stays in docs/.** It is not a benchmark of this box, but it is
// still the only record of the Phase 0 ground truth CLAUDE.md sends every new
// session to check — which Ollama tags are real, that `qwen3.8:27b-mlx` is
// Apple-only, that the danbooru CSV path everyone assumes exists does not. It
// also holds the quant size table, which is card-independent, and the original
// dialect baseline. Deleting it would lose all of that to remove some stale
// numbers; not listing it here removes the numbers from where they mislead.
//
// traits-eval stays despite predating the P40: it measures the danbooru
// character lookup against a local database and mentions no GPU, no VRAM and
// no tok/s anywhere. There is no hardware in it to be stale.

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Inline markdown, on already-escaped text.
 *
 * Order matters: code spans are pulled out FIRST and put back last, so that
 * `**not bold**` inside backticks stays literal. Every one of these documents
 * is full of tag names and shell fragments, which is exactly the text that
 * gets mangled by a renderer applying emphasis inside code.
 */
function inline(text) {
  const spans = [];
  let out = String(text).replace(/`([^`]+)`/g, (_, code) => {
    spans.push(code);
    return `\u0000${spans.length - 1}\u0000`;
  });

  out = out
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) =>
      /^(https?:|\/)/i.test(href) ? `<a href="${href}" rel="noreferrer">${label}</a>` : label
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${spans[Number(i)]}</code>`);
}

const isTableRow = (line) => /^\s*\|/.test(line);
const isTableRule = (line) => /^\s*\|[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
const cells = (line) =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/**
 * Markdown to HTML, covering exactly what these sheets use and nothing else.
 *
 * Counted before it was written: 159 table rows, 31 headings, 9 list items and
 * 12 code fences across the three markdown sheets. Tables are most of the
 * content and the whole reason this is not a `<pre>`.
 *
 * Deliberately not a markdown library. This project runs on three
 * dependencies and the rule in CLAUDE.md is boring and obvious over general —
 * a parser that handles reference links and setext headings would be more code
 * than this and would still only ever see these four files.
 */
export function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];

  const flush = () => {
    if (para.length) {
      out.push(`<p>${inline(esc(para.join(' ')))}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      flush();
      i += 1;
      continue;
    }

    // Fenced code. Everything inside is escaped and nothing else is applied.
    if (/^\s*```/.test(line)) {
      flush();
      const lang = line.trim().replace(/^`+/, '').trim();
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(
        `<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(esc(heading[2].trim()))}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(---+|===+|\*\*\*+)\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      i += 1;
      continue;
    }

    // Tables. A header row, a rule, then body rows until the block ends.
    if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && isTableRow(lines[i])) {
        body.push(cells(lines[i]));
        i += 1;
      }
      const th = head.map((c) => `<th>${inline(esc(c))}</th>`).join('');
      const rows = body
        .map((r) => `<tr>${r.map((c) => `<td>${inline(esc(c))}</td>`).join('')}</tr>`)
        .join('');
      // Wrapped so a wide table scrolls itself rather than the page.
      out.push(
        `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table></div>`
      );
      continue;
    }

    // Blockquotes. engine-eval opens with one — a seven-line note saying its
    // own numbers have been superseded by a later sheet, which is exactly the
    // kind of thing that must not render as a paragraph full of literal >.
    //
    // Recursive, so a quote keeps its bold, its code spans and any structure
    // inside it. Terminates because the marker is stripped before recursing.
    if (/^\s*>/.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push('<blockquote>' + renderMarkdown(body.join('\n')) + '</blockquote>');
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${items.map((t) => `<li>${inline(esc(t))}</li>`).join('')}</ul>`);
      continue;
    }

    para.push(line.trim());
    i += 1;
  }

  flush();
  return out.join('\n');
}

/**
 * The stylesheet for markdown-derived sheets.
 *
 * **Written entirely in the app's own variable names**, with no palette of its
 * own. The app has seven themes and they live in web/themes.css; a sheet
 * carrying its own colours would match exactly one of them and look wrong in
 * the other six, and would drift the first time a theme changed.
 *
 * The values arrive at runtime: the iframe is same-origin, so app.js copies
 * the parent's computed palette onto this document's root when it loads and
 * again whenever the theme changes. See paintBenchmarkFrame() there, and
 * BENCH_VARS for the list.
 *
 * Every var() still carries a fallback. If that copy never happens — a
 * direct hit on /api/benchmarks/<id> in a browser tab, which is a legitimate
 * way to read one — the sheet must still be readable rather than black on
 * black.
 */
const STYLE = `
body{background:var(--bg-base,#0d1117);color:var(--text-primary,#e2e8f0);margin:0;
padding:28px 32px 64px;font:15px/1.65 var(--sans,Inter,system-ui,sans-serif);
-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{line-height:1.25;margin:1.8em 0 .6em;font-weight:650}
h1{font-size:26px;margin-top:0;letter-spacing:-.01em}
h2{font-size:19px;padding-bottom:.35em;border-bottom:1px solid var(--border,#232d3b)}
h3{font-size:16px}h4{font-size:14px;color:var(--text-secondary,#7c8a9e)}
p{margin:.75em 0}
a{color:var(--accent,#22d3a7)}
strong{font-weight:650;color:var(--text-primary,#e2e8f0)}
code{font-family:var(--mono,ui-monospace,monospace);font-size:.88em;
background:var(--bg-elevated,#1a2233);padding:.12em .35em;border-radius:4px;
border:1px solid var(--border,#232d3b)}
pre{background:var(--bg-elevated,#1a2233);border:1px solid var(--border,#232d3b);
border-radius:var(--radius,8px);padding:12px 14px;overflow-x:auto;margin:1em 0}
pre code{background:none;border:0;padding:0;font-size:12.5px;line-height:1.55}
ul{margin:.75em 0;padding-left:1.3em}li{margin:.3em 0}
hr{border:0;border-top:1px solid var(--border,#232d3b);margin:2em 0}
/* engine-eval opens with one, saying its own numbers have been superseded.
   Amber rather than the accent: it is a caveat on everything below it, and it
   should read as one before the first table does. */
blockquote{margin:1.1em 0;padding:10px 14px;border-left:3px solid var(--accent-amber,#f59e0b);
background:var(--bg-elevated,#1a2233);border-radius:0 var(--radius,8px) var(--radius,8px) 0;
color:var(--text-secondary,#7c8a9e)}
blockquote p:first-child{margin-top:0}blockquote p:last-child{margin-bottom:0}
.table-wrap{overflow-x:auto;margin:1.1em 0;border:1px solid var(--border,#232d3b);
border-radius:var(--radius,8px);background:var(--bg-surface,#141a23)}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border,#232d3b);
vertical-align:top}
th{background:var(--bg-elevated,#1a2233);font-weight:650;white-space:nowrap;
color:var(--text-secondary,#7c8a9e);font-size:12px;letter-spacing:.02em;text-transform:uppercase}
tbody tr:last-child td{border-bottom:0}
td code{white-space:nowrap}
`;

/**
 * The hand-written sheet's palette, expressed in the app's variables.
 *
 * p40-bench-2026-09-03.html was authored standalone with its own light/dark
 * palette and twelve classes of bar chart, so its stylesheet cannot simply be
 * dropped — `track`, `bar`, `fill ok` and the rest are the sheet. This block
 * is appended AFTER its own <style> and redefines only the colour variables,
 * leaving every rule that uses them intact.
 *
 * `--accent` is deliberately absent: the sheet and the app happen to use the
 * same name for it, so the app's value is already what lands, and a
 * self-referential `--accent: var(--accent)` would resolve to nothing.
 */
const REMAP = `
:root{
--bg:var(--bg-base,#0d1117);
--surface:var(--bg-surface,#141a23);
--surface-2:var(--bg-elevated,#1a2233);
--ink:var(--text-primary,#e2e8f0);
--ink-soft:var(--text-secondary,#7c8a9e);
--ink-faint:var(--text-muted,#6e7e98);
--rule:var(--border,#232d3b);
--rule-strong:var(--border-light,#2a3648);
--accent-soft:var(--accent-glow,rgba(34,211,167,.12));
--good:var(--accent,#22d3a7);
--warn:var(--accent-amber,#f59e0b);
--crit:var(--accent-rose,#f43f5e);
--track:var(--bg-input,#0f151d);
}
body{font-family:var(--sans,Inter,system-ui,sans-serif)}
code,pre,.mono{font-family:var(--mono,ui-monospace,monospace)}
`;

/** Wrap a body in the document skeleton. */
function page(title, head, body) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${esc(title)}</title>${head}</head><body>${body}</body></html>`
  );
}

// ── The comparison sheet ─────────────────────────────────────────────────────
//
// Drawn from data/benchmarks/benchmarks.yaml rather than written by hand, which is the
// reason that file exists: when the second card arrived, the alternative was
// transcribing every P40 table into a new document and hoping nobody changed
// a number afterwards.
//
// A PAIR is one row on each machine carrying the same `pair` id. Rows without
// one are not drawn — a V100 number with no P40 counterpart is not a
// comparison, and it is still in the sheet it came from.
//
// The rule benchmarks.yaml opens with is enforced here, not trusted: any
// condition that differs within a pair is printed under its bars, in amber.
// Build is deliberately not compared; a different build per card is the
// point, and each machine's card says which.
//
// Colours are the app's variables only, the same as STYLE. The first machine
// is --text-muted and the second --accent: the card being compared against
// recedes and the one being measured stands out, in every theme.

const COMPARED = ['engine', 'context', 'kv_cache', 'draft_head'];

const CMP_STYLE = `
body{background:var(--bg-base,#0d1117);color:var(--text-primary,#e2e8f0);margin:0;
padding:28px 32px 64px;font:14px/1.55 var(--sans,Inter,system-ui,sans-serif);
-webkit-font-smoothing:antialiased}
.wrap{max-width:980px;margin:0 auto;display:flex;flex-direction:column;gap:34px}
h1{font-size:26px;margin:0;letter-spacing:-.01em;font-weight:650}
h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;margin:0 0 4px;
padding-bottom:8px;border-bottom:1px solid var(--border,#232d3b);font-weight:650}
section{display:flex;flex-direction:column;gap:12px}
.sub{color:var(--text-secondary,#7c8a9e);margin:6px 0 0;max-width:70ch}
.note{color:var(--text-muted,#6e7e98);font-size:12.5px;margin:0}
.legend{display:flex;gap:18px;font-size:12px;color:var(--text-secondary,#7c8a9e);margin-top:12px}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.m0 .fill,.sw.m0{background:var(--text-muted,#6e7e98)}
.m1 .fill,.sw.m1{background:var(--accent,#22d3a7)}
.machines{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.card,.pair,.headline{background:var(--bg-surface,#141a23);border:1px solid var(--border,#232d3b);
border-radius:var(--radius,8px)}
.card{padding:14px 16px}
.card h3{margin:0 0 8px;font-size:15px;font-weight:650;display:flex;align-items:center;gap:8px}
.card dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0;font-size:12.5px}
.card dt{color:var(--text-muted,#6e7e98)}
.card dd{margin:0;font-family:var(--mono,ui-monospace,monospace)}
.headline{border-left:3px solid var(--accent,#22d3a7);padding:18px 20px}
.jump{display:flex;align-items:baseline;gap:6px 14px;flex-wrap:wrap;
font-family:var(--mono,ui-monospace,monospace);font-variant-numeric:tabular-nums}
.jump .from{font-size:26px;color:var(--text-muted,#6e7e98)}
.jump .arrow{font-size:18px;color:var(--text-muted,#6e7e98)}
.jump .to{font-size:40px;font-weight:700;color:var(--accent,#22d3a7);letter-spacing:-.02em}
.jump .unit{color:var(--text-secondary,#7c8a9e);font-size:13px}
.headline p{margin:8px 0 0;color:var(--text-secondary,#7c8a9e)}
.pairs{display:flex;flex-direction:column;gap:10px}
.pair{padding:12px 14px}
.pair-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:6px}
.pair-label{font-weight:600}
.gain{font-family:var(--mono,ui-monospace,monospace);font-weight:700;font-size:13px;
color:var(--accent,#22d3a7);white-space:nowrap}
.gain.worse{color:var(--accent-rose,#f43f5e)}
.row{display:grid;grid-template-columns:48px 1fr 170px;align-items:center;gap:10px;margin:4px 0}
.who{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary,#7c8a9e)}
.track{position:relative;height:12px;background:var(--bg-input,#0f151d);border-radius:3px;overflow:hidden}
.fill{position:absolute;inset:0 auto 0 0;border-radius:3px}
.val{font-family:var(--mono,ui-monospace,monospace);font-variant-numeric:tabular-nums;
text-align:right;font-size:13px;white-space:nowrap}
.val small{color:var(--text-muted,#6e7e98);font-size:11px;margin-left:6px}
.missing{color:var(--text-muted,#6e7e98);font-size:12px}
.differs{margin-top:8px;font-size:12px;color:var(--accent-amber,#f59e0b)}
footer{color:var(--text-muted,#6e7e98);font-size:12.5px;border-top:1px solid var(--border,#232d3b);
padding-top:14px}
footer p{margin:0 0 6px}
@media (max-width:620px){body{padding:18px 14px 48px}.row{grid-template-columns:40px 1fr 118px}
.val small{display:none}}
`;

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Enough digits to read, no more: 618, 42.3, 6.06. */
function fmt(n, digits) {
  const d = digits ?? (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2);
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** A run's figure is the mean of its decode runs; a measure's is its value. */
const figure = (item) => (Array.isArray(item.decode_tok_s) ? mean(item.decode_tok_s) : item.value);

/** The individual runs, when there is more than one to show. */
const spread = (item) =>
  Array.isArray(item.decode_tok_s) && item.decode_tok_s.length > 1
    ? item.decode_tok_s.map((n) => fmt(n, 2)).join(' / ')
    : '';

/** Every way two rows of a pair were not taken under the same conditions. */
function differences(a, b) {
  const out = [];
  for (const k of COMPARED) {
    const x = a.conditions?.[k] ?? null;
    const y = b.conditions?.[k] ?? null;
    if (x !== y) out.push(`${k.replace('_', ' ')}: ${x ?? 'none'} / ${y ?? 'none'}`);
  }
  for (const note of [a.differs, b.differs].flat()) if (note) out.push(note);
  return out;
}

export function renderCompare(data) {
  const machines = data?.machines ?? {};
  const keys = Object.keys(machines).slice(0, 2);
  const short = (k) => machines[k]?.short ?? String(k).toUpperCase();
  const groupsMeta = data?.compare?.groups ?? {};

  // Collect pairs in file order, then group them by the sheet the first
  // machine's row came from, so each group shares one set of conditions.
  const pairs = new Map();
  const add = (item, kind) => {
    if (!item?.pair || !keys.includes(item.machine)) return;
    const p = pairs.get(item.pair) ?? { kind, items: {} };
    p.items[item.machine] = item;
    pairs.set(item.pair, p);
  };
  for (const r of data?.runs ?? []) add(r, 'run');
  for (const m of data?.measures ?? []) add(m, 'measure');

  const groups = new Map();
  for (const [id, p] of pairs) {
    const any = p.items[keys[0]] ?? p.items[keys[1]];
    const g = p.kind === 'measure' ? 'measures' : any.sheet;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([id, p]);
  }

  const bar = (i, item, max, unit, digits) => {
    const who = `<span class="who">${esc(short(keys[i]))}</span>`;
    if (!item) {
      return `<div class="row m${i}">${who}<span class="missing">not measured</span><span></span></div>`;
    }
    const v = figure(item);
    const pct = max > 0 ? Math.max(1, (v / max) * 100) : 0;
    const s = spread(item);
    return (
      `<div class="row m${i}">${who}` +
      `<span class="track"><span class="fill" style="width:${pct.toFixed(1)}%"></span></span>` +
      `<span class="val">${fmt(v, digits)} ${esc(unit)}${s ? `<small>${esc(s)}</small>` : ''}</span></div>`
    );
  };

  const pairBlock = (id, p, max, unit, better, digits) => {
    const a = p.items[keys[0]];
    const b = p.items[keys[1]];
    const label = a?.label ?? b?.label ?? a?.model ?? b?.model ?? id;
    let gain = '';
    if (a && b && figure(a) > 0 && figure(b) > 0) {
      const r = better === 'lower' ? figure(a) / figure(b) : figure(b) / figure(a);
      gain = `<span class="gain${r < 1 ? ' worse' : ''}">${fmt(r, 2)}×</span>`;
    }
    const diffs = a && b ? differences(a, b) : [];
    return (
      `<div class="pair" data-pair="${esc(id)}">` +
      `<div class="pair-head"><span class="pair-label">${esc(label)}</span>${gain}</div>` +
      bar(0, a, max, unit, digits) +
      bar(1, b, max, unit, digits) +
      (diffs.length ? `<div class="differs">Not identical: ${diffs.map(esc).join(' · ')}</div>` : '') +
      `</div>`
    );
  };

  const sections = [];

  // Headline: the deployment default, measured on both.
  const def = (data?.runs ?? []).find((r) => r.default && r.pair && pairs.get(r.pair)?.items[keys[1]]);
  if (def) {
    const a = pairs.get(def.pair).items[keys[0]];
    const b = pairs.get(def.pair).items[keys[1]];
    sections.push(
      `<div class="headline"><div class="jump">` +
      `<span class="from">${fmt(figure(a), 1)}</span><span class="arrow">→</span>` +
      `<span class="to">${fmt(figure(b), 1)}</span>` +
      `<span class="unit">tok/s · ${esc(def.label ?? def.model)}</span></div>` +
      `<p>The model the app writes with by default, ${esc(short(keys[0]))} against ` +
      `${esc(short(keys[1]))}, same weights and the same conditions.</p></div>`
    );
  }

  // Machines.
  const cardFor = (k, i) => {
    const m = machines[k] ?? {};
    const rows = [
      ['VRAM', m.vram_mib ? `${fmt(m.vram_mib, 0)} MiB` : null],
      ['Arch', [m.arch, m.compute && `compute ${m.compute}`].filter(Boolean).join(' · ') || null],
      ['Build', m.build ?? null],
      ['Driver', m.driver ?? null],
      ['Host', m.host ?? null],
    ].filter(([, v]) => v);
    return (
      `<div class="card"><h3><span class="sw m${i}"></span>${esc(m.name ?? k)}</h3><dl>` +
      rows.map(([t, v]) => `<dt>${esc(t)}</dt><dd>${esc(v)}</dd>`).join('') +
      `</dl></div>`
    );
  };
  sections.push(`<div class="machines">${keys.map(cardFor).join('')}</div>`);

  // Decode groups, one scale per group so bars inside it are comparable.
  for (const [g, list] of groups) {
    if (g === 'measures') continue;
    const meta = groupsMeta[g] ?? {};
    const max = Math.max(...list.flatMap(([, p]) => Object.values(p.items).map(figure)));
    sections.push(
      `<section><h2>${esc(meta.title ?? g)}</h2>` +
      (meta.note ? `<p class="note">${esc(meta.note)}</p>` : '') +
      `<div class="pairs">${list.map(([id, p]) => pairBlock(id, p, max, 'tok/s', 'higher', 2)).join('')}</div></section>`
    );
  }

  // VRAM, as a share of each card's own memory — headroom is the question.
  const pct = (item, k) =>
    item.vram_pct ?? (item.vram_mib && machines[k]?.vram_mib ? (item.vram_mib / machines[k].vram_mib) * 100 : null);
  const vramRows = [...pairs].filter(
    ([, p]) => p.kind === 'run' && keys.every((k) => p.items[k] && pct(p.items[k], k) != null)
  );
  if (vramRows.length) {
    const meta = groupsMeta.vram ?? {};
    const vbar = (i, item) => {
      const k = keys[i];
      const share = pct(item, k);
      const mib = item.vram_mib ?? Math.round((share / 100) * machines[k].vram_mib);
      return (
        `<div class="row m${i}"><span class="who">${esc(short(k))}</span>` +
        `<span class="track"><span class="fill" style="width:${Math.min(100, share).toFixed(1)}%"></span></span>` +
        `<span class="val">${fmt(share, 1)}%<small>${item.vram_mib ? '' : '≈'}${fmt(mib, 0)} MiB</small></span></div>`
      );
    };
    sections.push(
      `<section><h2>${esc(meta.title ?? 'VRAM')}</h2>` +
      (meta.note ? `<p class="note">${esc(meta.note)}</p>` : '') +
      `<div class="pairs">` +
      vramRows
        .map(([id, p]) => {
          const a = p.items[keys[0]];
          return (
            `<div class="pair" data-vram="${esc(id)}"><div class="pair-head">` +
            `<span class="pair-label">${esc(a.label ?? a.model ?? id)}</span></div>` +
            vbar(0, a) + vbar(1, p.items[keys[1]]) + `</div>`
          );
        })
        .join('') +
      `</div></section>`
    );
  }

  // One card only: a model that cannot have a counterpart on the other card —
  // it does not fit there — drawn on its own, one bar each, and labelled so.
  // Opt-in with `solo:` on the run, which carries the reason. Any other row
  // without a pair stays undrawn, per the rule at the top of this block: a
  // lone number is only shown when it says why it is alone.
  const solo = (data?.runs ?? []).filter((r) => r.solo && !r.pair && keys.includes(r.machine));
  if (solo.length) {
    const meta = groupsMeta.solo ?? {};
    const max = Math.max(...solo.map(figure));
    const block = (r) => {
      const share = pct(r, r.machine);
      const facts = [
        typeof r.solo === 'string' ? r.solo : null,
        share != null ? `${fmt(share, 1)}% of the card` : null,
        r.prefill_tok_s ? `prefill ${fmt(r.prefill_tok_s, 0)} tok/s` : null,
        r.acceptance ? `draft acceptance ${r.acceptance}` : null,
      ].filter(Boolean);
      return (
        `<div class="pair" data-solo="${esc(r.id)}"><div class="pair-head">` +
        `<span class="pair-label">${esc(r.label ?? r.model ?? r.id)}</span></div>` +
        bar(keys.indexOf(r.machine), r, max, 'tok/s', 2) +
        (facts.length ? `<p class="note">${facts.map(esc).join(' · ')}</p>` : '') +
        `</div>`
      );
    };
    sections.push(
      `<section><h2>${esc(meta.title ?? `${short(keys[1])} only`)}</h2>` +
      (meta.note ? `<p class="note">${esc(meta.note)}</p>` : '') +
      `<div class="pairs">${solo.map(block).join('')}</div></section>`
    );
  }

  // Measures: each pair is its own scale, because the units differ.
  const measured = groups.get('measures') ?? [];
  if (measured.length) {
    const meta = groupsMeta.measures ?? {};
    sections.push(
      `<section><h2>${esc(meta.title ?? 'Other measurements')}</h2>` +
      (meta.note ? `<p class="note">${esc(meta.note)}</p>` : '') +
      `<div class="pairs">` +
      measured
        .map(([id, p]) => {
          const any = p.items[keys[0]] ?? p.items[keys[1]];
          const max = Math.max(...Object.values(p.items).map(figure));
          return pairBlock(id, p, max, any.unit ?? '', any.better ?? 'higher', any.decimals);
        })
        .join('') +
      `</div></section>`
    );
  }

  const unpaired = [...(data?.runs ?? []), ...(data?.measures ?? [])].filter(
    (r) => !r.solo && (!r.pair || !keys.every((k) => pairs.get(r.pair)?.items[k]))
  ).length;

  const title = `${keys.map(short).join(' vs ')}`;
  const body =
    `<div class="wrap"><header><h1>${esc(title)}</h1>` +
    `<p class="sub">Every test the ${esc(short(keys[0]))} was measured on, re-run on the ` +
    `${esc(short(keys[1]))} under the same conditions. Longer bars are better except where a ` +
    `section says otherwise; the multiplier is how many times better the ${esc(short(keys[1]))} did.</p>` +
    `<div class="legend">${keys
      .map((k, i) => `<span><span class="sw m${i}"></span>${esc(machines[k]?.name ?? k)}</span>`)
      .join('')}</div></header>` +
    sections.join('') +
    `<footer><p>Drawn from <code>data/benchmarks/benchmarks.yaml</code>. Each row there cites the sheet that ` +
    `explains how it was measured.</p>` +
    (unpaired ? `<p>${unpaired} recorded result${unpaired === 1 ? ' has' : 's have'} no counterpart on the other card and ${unpaired === 1 ? 'is' : 'are'} not drawn here.</p>` : '') +
    `</footer></div>`;

  return page(title, `<style>${CMP_STYLE}</style>`, body);
}

// ── Where the sheets live (22 Sep 2026) ────────────────────────────────────
//
// data/benchmarks/, gitignored, not docs/. They are measurements of ONE box -
// the group's P40/V100 server - and the owner's call was that nobody else's
// hardware is close enough for them to mean anything on another install. So
// they stay on the box that measured them, like the pinboard, and a fresh
// install has none; the tab hides itself when the folder is empty.
//
// SHEETS above still gives the known ones their titles and summaries. Any
// other .md or .html dropped into the folder is listed too, titled from its
// file name, so someone measuring their own box can add sheets without
// editing code. That is a scan, which the note above argues against - but the
// argument was about docs/, which also holds the handoffs and the security
// plan. This folder holds nothing but sheets, and an id is only ever matched
// against the folder's own listing, never joined onto a path.

const EXTRA = /^[a-z0-9][a-z0-9._-]{0,80}\.(md|html)$/i;

// ── Latest results: the master sheet (22 Sep 2026) ──────────────────────────
//
// The owner asked for one sheet that "auto updates like a master sheet". It is
// not a file: it is drawn on request from every Run benchmark sheet in the
// folder, so it can never go stale or disagree with them. One row per model
// AND hardware - when the P40 goes back in beside the V100, the same model on
// each card is its own row, never an average of two cards.

const RUN_FILE = /^benchmark-\d{8}-\d{4}\.md$/;
const num = (s) => {
  const n = Number(String(s ?? '').replace(/\*/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

/** One run sheet written by server/benchrun.mjs, read back. Null if not one. */
export function parseRunSheet(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const when = /^#\s+Benchmark run,\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(lines[0] ?? '');
  if (!when) return null;
  const hw = /\*\*Hardware:\*\*\s+(.+?)\.\s+\*\*Backend:\*\*\s+([^.\s]+)/.exec(md);
  const rows = [];
  for (const line of lines) {
    if (!/^\|/.test(line) || /^\|\s*(Model|---)/.test(line)) continue;
    const c = line.split('|').slice(1, -1).map((x) => x.trim());
    if (c.length < 6) continue;
    const failed = /^failed:/.test(c[1]);
    rows.push({
      model: c[0],
      failed: failed ? c[1].replace(/^failed:\s*/, '') : null,
      first_reply_s: failed ? null : num(c[1]),
      prompt_tps: failed ? null : num(c[2]),
      decode_tps: failed ? null : num(c[3]),
    });
  }
  return { at: when[1], hardware: hw?.[1] ?? 'unknown hardware', backend: hw?.[2] ?? '', rows };
}

/** Latest result per model and hardware, with the change since the one before. */
export function latestResults(runs) {
  const byKey = new Map();
  for (const run of [...runs].sort((a, b) => a.at.localeCompare(b.at))) {
    for (const r of run.rows) {
      const key = `${run.hardware}|${r.model}`;
      const e = byKey.get(key) ?? { hardware: run.hardware, backend: run.backend, model: r.model, latest: null, previous: null, lastFailed: null };
      if (r.failed) {
        e.lastFailed = { at: run.at, why: r.failed };
      } else {
        e.previous = e.latest;
        e.latest = { ...r, at: run.at };
        e.lastFailed = null;
        e.backend = run.backend;
      }
      byKey.set(key, e);
    }
  }
  return [...byKey.values()];
}

function renderLatest(entries, runCount) {
  const fmt = (n, d = 1) => (n == null ? '—' : n.toFixed(d));
  const delta = (now, before) => {
    if (now == null || before == null) return '';
    const d = now - before;
    if (Math.abs(d) < 0.05) return ' (same)';
    return ` (${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)})`;
  };
  const md = [
    '# Latest results',
    '',
    `Each model's most recent Run benchmark on this machine, fastest writer first — drawn from ${runCount} run${runCount === 1 ? '' : 's'}, ` +
      'and updated every time one finishes. Brackets show the change in writing speed since that model\'s run before.',
  ];
  const groups = new Map();
  for (const e of entries) groups.set(e.hardware, [...(groups.get(e.hardware) ?? []), e]);
  for (const [hardware, rows] of groups) {
    md.push('', `## ${hardware}`, '');
    md.push('| Model | Writing (tok/s) | Prompt reading (tok/s) | First reply (cold, s) | Measured |');
    md.push('|---|---:|---:|---:|---|');
    rows.sort((a, b) => (b.latest?.decode_tps ?? -1) - (a.latest?.decode_tps ?? -1));
    for (const e of rows) {
      const l = e.latest;
      const note = e.lastFailed ? ` — last run ${e.lastFailed.at} failed` : '';
      md.push(l
        ? `| ${e.model} | **${fmt(l.decode_tps)}**${delta(l.decode_tps, e.previous?.decode_tps)} | ${fmt(l.prompt_tps, 0)} | ${fmt(l.first_reply_s)} | ${l.at}${note} |`
        : `| ${e.model} | failed | | | ${e.lastFailed.at}: ${e.lastFailed.why} |`);
    }
  }
  md.push('', '**Writing** is the speed to compare models by. **First reply** includes loading the model, so it mostly measures the drive. Open a dated run below for how any single run went.');
  return md.join('\n');
}

function headingOf(file) {
  if (!file.endsWith('.md')) return null;
  try {
    const first = readFileSync(file, 'utf8').slice(0, 400).split('\n').find((l) => l.trim());
    const m = /^#\s+(.{1,120})$/.exec(first ?? '');
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

export function createBenchmarks(rootDir, { dir = path.join('data', 'benchmarks') } = {}) {
  const base = path.resolve(rootDir, dir);
  const fileFor = (sheet) => path.join(base, sheet.file);

  /** Sheets in the folder that SHEETS does not describe. */
  function extras() {
    let names = [];
    try {
      names = readdirSync(base);
    } catch {
      return [];
    }
    const known = new Set(SHEETS.map((s) => s.file));
    return names
      .filter((n) => EXTRA.test(n) && !known.has(n))
      .map((n) => ({
        id: `local-${n.replace(/\.(md|html)$/i, '').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
        file: n,
        // A markdown sheet's own first heading, when it has one - the Run
        // benchmark button writes "# Benchmark run, <date>" - else the name.
        title: headingOf(path.join(base, n)) ?? n.replace(/\.(md|html)$/i, '').replace(/[-_]+/g, ' '),
        date: new Date(statSync(path.join(base, n)).mtimeMs).toISOString().slice(0, 10),
        summary: 'A sheet added to data/benchmarks/ on this machine.',
      }));
  }

  // Sheets added on this box - Run benchmark writes one - come first, newest
  // at the top, so a run you just finished is the one the tab opens on.
  const all = () => [...extras().sort((x, y) => y.date.localeCompare(x.date) || y.file.localeCompare(x.file)), ...SHEETS];

  /** Every Run benchmark sheet in the folder, read back. */
  function runs() {
    let names = [];
    try {
      names = readdirSync(base).filter((n) => RUN_FILE.test(n));
    } catch {
      return [];
    }
    return names
      .map((n) => {
        try {
          return parseRunSheet(readFileSync(path.join(base, n), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /** The master sheet's row in the list, while there is a run to draw it from. */
  function latestEntry() {
    const r = runs();
    if (!r.length) return null;
    const newest = r.map((x) => x.at).sort().pop();
    return {
      id: 'latest',
      title: 'Latest results',
      date: newest.slice(0, 10),
      summary: "Each model's most recent Run benchmark, fastest first. Updates itself after every run.",
      format: 'markdown',
      bytes: 0,
    };
  }

  /** The sheets that are actually on this box, with their sizes. */
  function list() {
    const latest = latestEntry();
    return [...(latest ? [latest] : []), ...listFiles()];
  }

  function listFiles() {
    return all().filter((s) => existsSync(fileFor(s))).map((s) => ({
      id: s.id,
      title: s.title,
      date: s.date,
      summary: s.summary,
      format: s.generated || s.file.endsWith('.html') ? 'html' : 'markdown',
      bytes: statSync(fileFor(s)).size,
    }));
  }

  /**
   * One sheet, as a complete standalone HTML document.
   *
   * Complete rather than a fragment because it is shown in an iframe, and the
   * iframe is the point: p40-bench carries its own 200-line stylesheet, and
   * injecting that into the app would restyle the app. Isolation here costs
   * nothing and removes a whole category of collision.
   */
  function render(id) {
    if (id === 'latest') {
      const r = runs();
      if (!r.length) return null;
      return page('Latest results', `<style>${STYLE}</style>`, renderMarkdown(renderLatest(latestResults(r), r.length)));
    }
    const sheet = all().find((s) => s.id === id);
    if (!sheet) return null;
    const abs = fileFor(sheet);
    if (!existsSync(abs)) return null;
    const raw = readFileSync(abs, 'utf8');

    // Data, not a document: draw the sheet from it. A file that no longer
    // parses gets a page saying so rather than a 500, because the tab shows
    // whatever this returns in its frame.
    if (sheet.generated) {
      let data;
      try {
        data = YAML.parse(raw);
      } catch (err) {
        return page(sheet.title, `<style>${STYLE}</style>`,
          `<p>data/benchmarks/${esc(sheet.file)} does not parse: ${esc(err.message)}</p>`);
      }
      return renderCompare(data);
    }

    // The .html sheet was authored as an artifact body — a <title>, a <style>
    // and content, with no skeleton. Served inside one, with REMAP appended
    // after its own stylesheet so the app's palette wins on colour and its
    // own rules keep everything else.
    if (sheet.file.endsWith('.html')) {
      return page(sheet.title, '', `${raw}<style>${REMAP}</style>`);
    }

    return page(sheet.title, `<style>${STYLE}</style>`, renderMarkdown(raw));
  }

  return { list, render, ids: () => all().map((s) => s.id) };
}
